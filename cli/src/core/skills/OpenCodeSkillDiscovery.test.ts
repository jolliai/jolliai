import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setManuallyDisabled } from "../../Logger.js";
import {
	OC_ASSISTANT_MESSAGE,
	OC_NON_SKILL_TOOL,
	OC_SKILL_NO_TOP_METADATA,
	OC_SKILL_WITH_TOP_METADATA,
} from "./__fixtures__/openCodeParts.js";

/**
 * The DB path is resolved by the OpenCode session discoverer; point it at a temp
 * database built with the real schema so these tests exercise the actual SQL.
 */
const { dbPathRef } = vi.hoisted(() => ({ dbPathRef: { current: "" } }));
vi.mock("../OpenCodeSessionDiscoverer.js", () => ({
	getOpenCodeDbPath: () => dbPathRef.current,
}));

/**
 * Isolate the developer's real `~/.jolli/jollimemory/config.json` from the run.
 * `loadConfig` reads the MACHINE-GLOBAL config, so the `openCodeEnabled` toggle
 * cannot be exercised (or neutralised) through the temp project dir at all:
 * `discoverOpenCodeSkills` short-circuits when `config.openCodeEnabled === false`,
 * so a developer who disabled OpenCode locally (a valid preference) would
 * silently see every test in this file return 0 without any tooling clue —
 * the failure surface looks identical to a bug in the SQL / matcher paths.
 * The empty default is a `mockResolvedValue`, not a `mockResolvedValueOnce`, so
 * the toggle test below can still queue its own value on top for one call
 * (`clearMocks` clears calls, not implementations).
 * Preserve every other export via `importOriginal` because the test itself
 * calls `loadPlansRegistry` and the discovery under test calls
 * `upsertSkillEntry`, both real, on top of `SessionTracker`.
 */
vi.mock("../SessionTracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../SessionTracker.js")>();
	return {
		...actual,
		loadConfig: vi.fn().mockResolvedValue({}),
	};
});

import { loadConfig, loadPlansRegistry } from "../SessionTracker.js";

const { discoverOpenCodeSkills } = await import("./OpenCodeSkillDiscovery.js");

/** Builds a DB with OpenCode's real table shapes for `session`, `part` and `message`. */
async function buildDb(
	path: string,
	rows: {
		sessions: Array<{ id: string; directory: string | null; timeCreated?: number }>;
		parts: Array<{ id: string; sessionId: string; timeCreated: number; data: string }>;
		messages?: Array<{ id: string; sessionId: string; timeCreated: number; data: string }>;
	},
): Promise<void> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER)");
	db.exec("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
	db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
	const now = Date.now();
	for (const s of rows.sessions) {
		db.prepare("INSERT INTO session VALUES (?,?,?)").run(s.id, s.directory, s.timeCreated ?? now);
	}
	for (const p of rows.parts) {
		db.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run(p.id, "msg_x", p.sessionId, p.timeCreated, p.data);
	}
	for (const m of rows.messages ?? []) {
		db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(m.id, m.sessionId, m.timeCreated, m.data);
	}
	db.close();
}

describe("discoverOpenCodeSkills", () => {
	let cwd: string;
	let dbDir: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "oc-skill-cwd-"));
		dbDir = await mkdtemp(join(tmpdir(), "oc-skill-db-"));
		dbPathRef.current = join(dbDir, "opencode.db");
	});

	afterEach(async () => {
		setManuallyDisabled(false);
		await rm(cwd, { recursive: true, force: true });
		await rm(dbDir, { recursive: true, force: true });
	});

	it("persists a skill from a session run in this repo", async () => {
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_1", directory: cwd }],
			parts: [{ id: "prt_1", sessionId: "ses_1", timeCreated: Date.now(), data: OC_SKILL_NO_TOP_METADATA }],
		});

		expect(await discoverOpenCodeSkills(cwd)).toBe(1);
		const entry = (await loadPlansRegistry(cwd)).skills?.["opencode:jolli"];
		expect(entry?.skill).toBe("jolli");
		expect(entry?.source).toBe("opencode");
		expect(entry?.commitHash).toBeNull();
	});

	it("includes a session started from a SUBDIRECTORY of the repo", async () => {
		// Real data has exactly this: a session whose directory is <repo>/intellij. A
		// SQL `directory = :cwd` test silently dropped every such session (JOLLI-2015),
		// which is why the match runs through the shared helper instead.
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_sub", directory: join(cwd, "intellij") }],
			parts: [{ id: "prt_1", sessionId: "ses_sub", timeCreated: Date.now(), data: OC_SKILL_NO_TOP_METADATA }],
		});
		expect(await discoverOpenCodeSkills(cwd)).toBe(1);
	});

	it("excludes a sibling directory that merely shares a name prefix", async () => {
		// Real data has `<repo>-worktrees/...` alongside `<repo>`. A naive prefix test
		// matches it; the separator boundary in the shared helper is what rejects it.
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_other", directory: `${cwd}-worktrees/feature/x` }],
			parts: [{ id: "prt_1", sessionId: "ses_other", timeCreated: Date.now(), data: OC_SKILL_NO_TOP_METADATA }],
		});
		expect(await discoverOpenCodeSkills(cwd)).toBe(0);
		expect((await loadPlansRegistry(cwd)).skills).toBeUndefined();
	});

	it("survives a session row with a null directory", async () => {
		// One null directory used to throw out of the matcher and take the whole batch
		// down — the same poison-row failure that broke Copilot capture.
		await buildDb(dbPathRef.current, {
			sessions: [
				{ id: "ses_null", directory: null },
				{ id: "ses_ok", directory: cwd },
			],
			parts: [{ id: "prt_1", sessionId: "ses_ok", timeCreated: Date.now(), data: OC_SKILL_NO_TOP_METADATA }],
		});
		expect(await discoverOpenCodeSkills(cwd)).toBe(1);
	});

	it("attributes spend from the same session only", async () => {
		// Interval attribution is positional within ONE conversation. If two sessions
		// shared a timeline, one session's turns would be billed to the other's skill.
		const t = Date.now();
		await buildDb(dbPathRef.current, {
			sessions: [
				{ id: "ses_a", directory: cwd },
				{ id: "ses_b", directory: cwd },
			],
			parts: [{ id: "prt_1", sessionId: "ses_a", timeCreated: t, data: OC_SKILL_NO_TOP_METADATA }],
			messages: [
				{ id: "msg_a", sessionId: "ses_a", timeCreated: t + 100, data: OC_ASSISTANT_MESSAGE },
				{ id: "msg_b", sessionId: "ses_b", timeCreated: t + 200, data: OC_ASSISTANT_MESSAGE },
			],
		});
		await discoverOpenCodeSkills(cwd);
		const entry = (await loadPlansRegistry(cwd)).skills?.["opencode:jolli"];
		// One session's worth (89/151), not two.
		expect(entry?.usage).toEqual({ input: 89, cached: 0, output: 151, confidence: "estimated" });
	});

	it("records the session key so a detached conversation can be subtracted", async () => {
		const t = Date.now();
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_a", directory: cwd }],
			parts: [{ id: "prt_1", sessionId: "ses_a", timeCreated: t, data: OC_SKILL_NO_TOP_METADATA }],
			messages: [{ id: "msg_a", sessionId: "ses_a", timeCreated: t + 100, data: OC_ASSISTANT_MESSAGE }],
		});
		await discoverOpenCodeSkills(cwd);
		const entry = (await loadPlansRegistry(cwd)).skills?.["opencode:jolli"];
		expect(Object.keys(entry?.usageBySession ?? {})).toEqual(["opencode:ses_a"]);
	});

	it("ignores non-skill tool rows", async () => {
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_1", directory: cwd }],
			parts: [{ id: "prt_1", sessionId: "ses_1", timeCreated: Date.now(), data: OC_NON_SKILL_TOOL }],
		});
		expect(await discoverOpenCodeSkills(cwd)).toBe(0);
	});

	it("is a silent no-op when OpenCode is not installed", async () => {
		dbPathRef.current = join(dbDir, "does-not-exist.db");
		await expect(discoverOpenCodeSkills(cwd)).resolves.toBe(0);
	});

	it("is a silent no-op when the database cannot be read", async () => {
		// Runs fire-and-forget on a UI tick — a corrupt DB must never surface as an
		// error on the surface it feeds.
		const { writeFile } = await import("node:fs/promises");
		await writeFile(dbPathRef.current, "definitely not sqlite", "utf-8");
		await expect(discoverOpenCodeSkills(cwd)).resolves.toBe(0);
	});

	it("does not re-count an invocation on a second pass", async () => {
		// The tick runs every 60 seconds against the same rows.
		const t = Date.now();
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_1", directory: cwd }],
			parts: [{ id: "prt_1", sessionId: "ses_1", timeCreated: t, data: OC_SKILL_NO_TOP_METADATA }],
		});
		await discoverOpenCodeSkills(cwd);
		await discoverOpenCodeSkills(cwd);
		expect((await loadPlansRegistry(cwd)).skills?.["opencode:jolli"]?.invocationCount).toBe(1);
	});

	it("writes nothing while the project is manually disabled", async () => {
		// The 60s tick keeps firing behind a disabled panel; a pass must not put
		// files back into a project the user switched off.
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_1", directory: cwd }],
			parts: [{ id: "prt_1", sessionId: "ses_1", timeCreated: Date.now(), data: OC_SKILL_NO_TOP_METADATA }],
		});
		setManuallyDisabled(true);
		expect(await discoverOpenCodeSkills(cwd)).toBe(0);
		expect((await loadPlansRegistry(cwd)).skills).toBeUndefined();
	});

	it("writes nothing when OpenCode discovery is switched off in config", async () => {
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_1", directory: cwd }],
			parts: [{ id: "prt_1", sessionId: "ses_1", timeCreated: Date.now(), data: OC_SKILL_NO_TOP_METADATA }],
		});
		vi.mocked(loadConfig).mockResolvedValueOnce({ openCodeEnabled: false });
		expect(await discoverOpenCodeSkills(cwd)).toBe(0);
	});

	it("de-duplicates a concurrent tick instead of running the scan twice", async () => {
		// Two overlapping ticks must share ONE pass; a second scan would fold the
		// same invocation in again before the first pass has written its cursor.
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_1", directory: cwd }],
			parts: [{ id: "prt_1", sessionId: "ses_1", timeCreated: Date.now(), data: OC_SKILL_NO_TOP_METADATA }],
		});
		const [a, b] = await Promise.all([discoverOpenCodeSkills(cwd), discoverOpenCodeSkills(cwd)]);
		expect([a, b]).toEqual([1, 1]);
		expect((await loadPlansRegistry(cwd)).skills?.["opencode:jolli"]?.invocationCount).toBe(1);
	});

	it("collects several parts of one session into a single group", async () => {
		// The grouper creates a session bucket on first sight and reuses it for every
		// later part — a per-part bucket would split one conversation's timeline in
		// two and mis-attribute the interval spend.
		const t = Date.now();
		await buildDb(dbPathRef.current, {
			sessions: [{ id: "ses_a", directory: cwd }],
			parts: [
				{ id: "prt_1", sessionId: "ses_a", timeCreated: t, data: OC_SKILL_NO_TOP_METADATA },
				{ id: "prt_2", sessionId: "ses_a", timeCreated: t + 50, data: OC_SKILL_WITH_TOP_METADATA },
			],
			messages: [{ id: "msg_1", sessionId: "ses_a", timeCreated: t + 100, data: OC_ASSISTANT_MESSAGE }],
		});
		expect(await discoverOpenCodeSkills(cwd)).toBe(2);
		// Both parts land in ONE group, so both skills are scanned against the same
		// session timeline (and both carry that session's key), rather than being
		// split into two disjoint single-part groups.
		const skills = (await loadPlansRegistry(cwd)).skills ?? {};
		expect(Object.keys(skills).sort()).toEqual(["opencode:comprehensive-review-full-review", "opencode:jolli"]);
		expect(Object.keys(skills["opencode:comprehensive-review-full-review"]?.usageBySession ?? {})).toEqual([
			"opencode:ses_a",
		]);
	});
});
